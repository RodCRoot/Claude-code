import { asDT, asText, splitName, ageOn } from "../normalize";
import type { FieldDef, FieldValue, IdentityInput, NormalizeCtx, NormalizedRow } from "../types";

/** Person identification fields shared by most schemas. */
export function personFields(opts: { idAliases?: string[]; idLabel?: string; nameAliases?: string[] } = {}): FieldDef[] {
  return [
    { key: "source_person_id", label: opts.idLabel ?? "Source person ID", type: "text", aliases: opts.idAliases ?? ["member id", "person id", "athlete id", "external id", "user id"] },
    { key: "full_name", label: "Full name", type: "text", aliases: opts.nameAliases ?? ["name", "full name", "member", "member name", "athlete", "athlete name"] },
    { key: "first_name", label: "First name", type: "text", aliases: ["first name", "firstname", "first", "given name"] },
    { key: "last_name", label: "Last name", type: "text", aliases: ["last name", "lastname", "last", "surname", "family name"] },
    { key: "dob", label: "Date of birth", type: "date", aliases: ["birth date", "birthdate", "date of birth", "dob", "birthday"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address", "e-mail"] },
  ];
}

export function resolveName(f: Record<string, FieldValue>): { first: string | null; last: string | null } {
  const first = asText(f.first_name);
  const last = asText(f.last_name);
  if (first || last) return { first, last };
  return splitName(asText(f.full_name));
}

export function identityFrom(
  f: Record<string, FieldValue>,
  ctx: NormalizeCtx,
  opts: { sourceEntityType: string; needsAthlete: boolean; adult?: boolean },
  errors: string[],
): IdentityInput | null {
  const { first, last } = resolveName(f);
  const sourceId = asText(f.source_person_id);
  if (!sourceId && (!first || !last)) {
    errors.push("Person not identifiable: need a source ID or both first and last name.");
    return null;
  }
  const dob = asText(f.dob);
  const today = new Date().toISOString().slice(0, 10);
  return {
    sourceEntityType: opts.sourceEntityType,
    sourceId,
    firstName: first,
    lastName: last,
    dob,
    email: asText(f.email),
    phone: asText(f.phone),
    adult: opts.adult ?? (dob ? ageOn(dob, today) >= 18 : false),
    needsAthlete: opts.needsAthlete,
  };
}

export function emptyRow(): NormalizedRow {
  return { data: {}, errors: [], warnings: [], sourceRecordId: null, identity: null, dates: [] };
}

export function requireDT(f: Record<string, FieldValue>, key: string, label: string, errors: string[]) {
  const v = asDT(f[key]);
  if (!v) errors.push(`${label} is required.`);
  return v;
}

export const DATETIME_HINT = "Offsets like -05:00 are kept verbatim; times without an offset are read as facility local time.";
