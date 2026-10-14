import { asText, syntheticId } from "../normalize";
import type { ImportSchemaDef, IdentityInput, NormalizedRow } from "../types";
import { emptyRow } from "./common";

/**
 * GoHighLevel contact export, as Teamwork uses GHL:
 * - the contact record is filed under the ATHLETE's name ("Riley Example"), often several siblings
 *   sharing a surname in one contact ("Riley, Sam, Alex Example" / "Riley & Sam Example");
 * - the phone and email on the contact belong to the PARENT (whose name usually isn't on it).
 *
 * So one contact row becomes one import row per athlete (same file line number), each identified by
 * name only (never by the parent's email/phone, which would wrongly match the parent). Name-only
 * matches are always "ambiguous" → staff review; nothing is merged automatically. The phone/email
 * become the guardian contact: an existing person with that exact email/phone is proposed as the
 * guardian (staff confirm in review); otherwise a placeholder guardian record ("Parent/guardian of …")
 * is created per contact holding the phone/email, for staff to complete.
 */

const GHL_LIMITS =
  "GoHighLevel contact export (CSV). Column names follow GHL's Contacts → Export; every mapping is editable. Contact names are athlete names; phone/email are the parent's. Several first names before one surname are split into siblings. Nothing is sent to GHL, and no messages, memberships or charges are created. Placeholder guardians have no real name: complete them in People.";

/** Split a GHL contact name into athlete first names + shared surname. */
export function parseGhlContactName(input: { full?: string | null; first?: string | null; last?: string | null }): {
  firstNames: string[];
  lastName: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const clean = (s: string | null | undefined) =>
    (s ?? "")
      .replace(/\([^)]*\)/g, (m) => {
        warnings.push(`Ignored "${m.trim()}" in the contact name.`);
        return " ";
      })
      .replace(/\s+/g, " ")
      .trim();
  let firstPart: string;
  let lastName: string | null;
  const first = clean(input.first);
  const last = clean(input.last);
  if (first || last) {
    firstPart = first;
    lastName = last || null;
    // "First Name" sometimes holds the whole contact name; take the surname from it when Last Name is empty.
    if (!lastName && /\s/.test(firstPart)) {
      const i = firstPart.lastIndexOf(" ");
      lastName = firstPart.slice(i + 1);
      firstPart = firstPart.slice(0, i);
    }
  } else {
    const full = clean(input.full);
    const i = full.lastIndexOf(" ");
    if (i < 0) return { firstNames: full ? [full] : [], lastName: null, warnings };
    firstPart = full.slice(0, i);
    lastName = full.slice(i + 1);
  }
  const firstNames = firstPart
    .split(/\s*(?:,|&|\+|\/|;|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (firstNames.length > 1) warnings.push(`One GHL contact covers ${firstNames.length} athletes: ${firstNames.map((f) => `${f} ${lastName ?? ""}`.trim()).join(", ")}.`);
  for (const f of firstNames) if (/\s/.test(f)) warnings.push(`"${f} ${lastName ?? ""}" has more than one word before the surname. Check the first/last name split.`);
  return { firstNames, lastName, warnings };
}

export const ghlContacts: ImportSchemaDef = {
  id: "gohighlevel.contacts",
  source: "gohighlevel",
  idSource: "gohighlevel",
  label: "GoHighLevel: Contacts (athlete name, parent phone/email)",
  description:
    "GHL contact export. Each contact name becomes one or more athletes (siblings sharing a surname are split); the contact's phone/email become the parent/guardian contact. Every person match goes through identity review.",
  evidence: "unverified — configurable",
  recordEntityType: "contact_athlete",
  allowCreatePerson: true,
  limitations: GHL_LIMITS,
  fields: [
    { key: "contact_id", label: "GHL contact ID", type: "text", aliases: ["contact id", "id", "contactid", "ghl id"] },
    { key: "full_name", label: "Contact name", type: "text", aliases: ["contact name", "name", "full name", "contact"] },
    { key: "first_name", label: "First name", type: "text", aliases: ["first name", "firstname", "first"] },
    { key: "last_name", label: "Last name", type: "text", aliases: ["last name", "lastname", "last"] },
    { key: "phone", label: "Phone (parent)", type: "text", aliases: ["phone", "phone number", "mobile", "mobile phone", "cell"] },
    { key: "email", label: "Email (parent)", type: "email", aliases: ["email", "email address"] },
    { key: "tags", label: "Tags", type: "text", aliases: ["tags", "tag"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const parsed = parseGhlContactName({ full: asText(f.full_name), first: asText(f.first_name), last: asText(f.last_name) });
    r.warnings.push(...parsed.warnings);
    if (!parsed.firstNames.length || !parsed.lastName) r.errors.push("Contact name needs at least one first name and a surname (e.g. \"Riley Example\" or \"Riley, Sam Example\").");
    const contactId = asText(f.contact_id);
    const phone = asText(f.phone);
    const email = asText(f.email)?.toLowerCase() ?? null;
    if (!phone && !email) r.warnings.push("No phone or email on this contact: no guardian contact will be recorded.");
    const householdKey = contactId ?? syntheticId(ctx.orgId, "ghl-contact", parsed.lastName?.toLowerCase(), phone, email);
    r.data = {
      contactId,
      contactName: asText(f.full_name) ?? [asText(f.first_name), asText(f.last_name)].filter(Boolean).join(" "),
      athletes: parsed.firstNames.map((first) => ({ first, last: parsed.lastName })),
      lastName: parsed.lastName,
      guardianContact: { phone, email },
      householdKey,
      householdName: `${parsed.lastName ?? "Imported"} Household`,
      tags: asText(f.tags),
    };
    r.sourceRecordId = householdKey;
    return r;
  },
  /** One import row per athlete named on the contact. */
  split(row: NormalizedRow): NormalizedRow[] {
    const athletes = (row.data.athletes as { first: string; last: string | null }[] | undefined) ?? [];
    if (row.errors.length || athletes.length === 0) return [row];
    const contactKey = String(row.data.householdKey);
    return athletes.map((a, i) => {
      const identity: IdentityInput = {
        sourceEntityType: "contact_athlete",
        sourceId: `${contactKey}#${a.first.toLowerCase()}`,
        firstName: a.first,
        lastName: a.last,
        dob: null,
        // Deliberately no email/phone: they are the parent's, not the athlete's.
        email: null,
        phone: null,
        adult: false,
        needsAthlete: true,
      };
      return {
        ...row,
        warnings: i === 0 ? row.warnings : row.warnings.filter((w) => !w.startsWith("One GHL contact covers")),
        data: { ...row.data, firstName: a.first, lastName: a.last, siblingIndex: i, siblingCount: athletes.length },
        identity,
        sourceRecordId: `${contactKey}#${a.first.toLowerCase()}`,
      };
    });
  },
};
