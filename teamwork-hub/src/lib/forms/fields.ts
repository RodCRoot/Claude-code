import { z } from "zod";
import type { FormField, SignerRequirement } from "@/db/schema";

export const FIELD_TYPES = ["text", "textarea", "date", "checkbox", "select", "phone", "email"] as const;
export const SIGNER_ROLES = ["guardian", "second_guardian", "adult_athlete", "athlete_assent", "staff_witness"] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const SIGNER_ROLE_LABEL: Record<SignerRole, string> = {
  guardian: "Parent / guardian",
  second_guardian: "Second parent / guardian",
  adult_athlete: "Adult athlete (18+)",
  athlete_assent: "Athlete assent (minor)",
  staff_witness: "Staff witness",
};

/** Field definitions as edited by staff. Keys are stable machine names. */
export const fieldDefSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "Key must start with a letter and use lowercase letters, digits, or _ (max 40)."),
    label: z.string().trim().min(1, "Label is required.").max(200),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "select" && (!f.options || f.options.length < 1)) {
      ctx.addIssue({ code: "custom", message: `Select field "${f.key}" needs at least one option.`, path: ["options"] });
    }
  });

export const fieldListSchema = z
  .array(fieldDefSchema)
  .max(60)
  .superRefine((fs, ctx) => {
    const seen = new Set<string>();
    for (const f of fs) {
      if (seen.has(f.key)) ctx.addIssue({ code: "custom", message: `Duplicate field key "${f.key}".` });
      seen.add(f.key);
    }
  });

export const signerListSchema = z
  .array(z.object({ role: z.enum(SIGNER_ROLES), required: z.boolean() }))
  .superRefine((ss, ctx) => {
    const seen = new Set<string>();
    for (const s of ss) {
      if (seen.has(s.role)) ctx.addIssue({ code: "custom", message: `Signer role "${s.role}" listed twice.` });
      seen.add(s.role);
    }
  });

export function normalizeFields(fields: FormField[]): FormField[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    ...(f.type === "select" ? { options: f.options ?? [] } : {}),
  }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\-.\s\d]{7,25}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Server-side validation of submitted values against the version's field
 * definitions. Unknown keys are dropped; values are trimmed and typed.
 */
export function validateSubmission(
  fields: FormField[],
  raw: Record<string, unknown>,
): { ok: true; data: Record<string, string | boolean> } | { ok: false; errors: Record<string, string> } {
  const data: Record<string, string | boolean> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const name = `field_${f.key}`;
    const v = raw[name] ?? raw[f.key];
    if (f.type === "checkbox") {
      const checked = v === true || v === "on" || v === "true" || v === "yes";
      if (f.required && !checked) errors[name] = `${f.label} must be checked.`;
      data[f.key] = checked;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : Array.isArray(v) ? String(v[0] ?? "").trim() : "";
    if (!s) {
      if (f.required) errors[name] = `${f.label} is required.`;
      else data[f.key] = "";
      continue;
    }
    const max = f.type === "textarea" ? 4000 : 300;
    if (s.length > max) {
      errors[name] = `${f.label} is too long (max ${max} characters).`;
      continue;
    }
    switch (f.type) {
      case "email":
        if (!EMAIL_RE.test(s)) errors[name] = `${f.label} must be an email address.`;
        break;
      case "phone":
        if (!PHONE_RE.test(s) || s.replace(/\D/g, "").length < 7) errors[name] = `${f.label} must be a phone number.`;
        break;
      case "date": {
        const d = new Date(`${s}T12:00:00Z`);
        if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) errors[name] = `${f.label} must be a valid date.`;
        break;
      }
      case "select":
        if (!(f.options ?? []).includes(s)) errors[name] = `${f.label}: choose one of the listed options.`;
        break;
    }
    data[f.key] = s;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}

/** Display a stored value. */
export function displayValue(f: FormField | undefined, v: unknown): string {
  if (v === true) return "Yes";
  if (v === false) return f?.type === "checkbox" ? "No" : "";
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/**
 * Signer roles that must sign before a request is complete, given the subject's
 * age and how many guardians may sign.
 * - Adult subject: guardian roles do not apply; if the version lists guardian or
 *   adult_athlete as required, the adult athlete must sign. Assent is not needed.
 * - Minor subject: adult_athlete does not apply. A required second_guardian is
 *   only required when a second guardian with signing permission exists.
 */
export function requiredRoles(
  signers: SignerRequirement[],
  opts: { subjectIsAdult: boolean; signingGuardianCount: number },
): SignerRole[] {
  const req = new Set(signers.filter((s) => s.required).map((s) => s.role as SignerRole));
  const out = new Set<SignerRole>();
  if (opts.subjectIsAdult) {
    if (req.has("guardian") || req.has("adult_athlete") || req.has("second_guardian")) out.add("adult_athlete");
  } else {
    if (req.has("guardian")) out.add("guardian");
    if (req.has("second_guardian") && opts.signingGuardianCount >= 2) out.add("second_guardian");
    if (req.has("athlete_assent")) out.add("athlete_assent");
  }
  if (req.has("staff_witness")) out.add("staff_witness");
  return [...out];
}

/** Roles that may sign at all (required or optional) for this subject. */
export function applicableRoles(signers: SignerRequirement[], subjectIsAdult: boolean): SignerRole[] {
  const listed = new Set(signers.map((s) => s.role as SignerRole));
  const out: SignerRole[] = [];
  for (const r of SIGNER_ROLES) {
    if (subjectIsAdult) {
      if (r === "adult_athlete" && (listed.has("adult_athlete") || listed.has("guardian"))) out.push(r);
      if (r === "staff_witness" && listed.has(r)) out.push(r);
    } else {
      if (r === "adult_athlete") continue;
      if (listed.has(r)) out.push(r);
    }
  }
  return out;
}

export function ageOn(dob: string | null, at: Date): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const ay = at.getUTCFullYear();
  const am = at.getUTCMonth() + 1;
  const ad = at.getUTCDate();
  let age = ay - y;
  if (am < m || (am === m && ad < d)) age--;
  return age;
}

export const ADULT_AGE = 18;
