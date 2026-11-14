import { asDT, asNum, asText, syntheticId, zonedLocalToInstant, splitName, localDateOf } from "../normalize";
import type { ImportSchemaDef } from "../types";
import { emptyRow, identityFrom, personFields, resolveName } from "./common";

const ZP_ID = ["member id", "zp id", "person id", "user id", "id", "member #"];

const ZP_LIMITS =
  "Zen Planner has no public API we can use; these are report exports (CSV). Column names vary with the columns chosen in each report, so every mapping is editable. Billing stays in Zen Planner: nothing here creates invoices, charges, subscriptions, messages, or jobs.";

const PERSON_STATUS: Record<string, "active" | "inactive" | "prospect" | "lead"> = {
  active: "active",
  member: "active",
  inactive: "inactive",
  former: "inactive",
  alumni: "inactive",
  cancelled: "inactive",
  canceled: "inactive",
  prospect: "prospect",
  lead: "lead",
};

export const zpMembers: ImportSchemaDef = {
  id: "zenplanner.members",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — People / member list",
  description: "People report export. Creates people (and athlete records unless the row is a parent/guardian), or links to existing people.",
  evidence: "unverified — configurable",
  recordEntityType: "member",
  allowCreatePerson: true,
  limitations: ZP_LIMITS + " Existing Teamwork people are never overwritten: only empty fields are filled, and conflicts are reported as warnings.",
  fields: [
    ...personFields({ idAliases: ZP_ID, idLabel: "Zen Planner member ID" }),
    { key: "phone", label: "Phone", type: "text", aliases: ["phone", "mobile", "cell", "cell phone", "primary phone", "mobile phone"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "member status"] },
    { key: "person_type", label: "Person type (athlete / parent)", type: "text", aliases: ["type", "person type", "role", "member type"], hint: "Rows with parent/guardian are created as people without an athlete record." },
    { key: "signup_date", label: "Signup date", type: "date", aliases: ["signup date", "join date", "member since", "created"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const { first, last } = resolveName(f);
    const type = (asText(f.person_type) ?? "").toLowerCase();
    const isGuardian = /parent|guardian|payer|mother|father/.test(type);
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: !isGuardian, adult: isGuardian || undefined }, r.errors);
    const statusText = asText(f.status);
    let status: string | null = null;
    if (statusText) {
      status = PERSON_STATUS[statusText.toLowerCase()] ?? null;
      if (!status) r.warnings.push(`Status "${statusText}" not recognized; status left unchanged/default.`);
    }
    r.data = {
      firstName: first,
      lastName: last,
      dob: asText(f.dob),
      email: asText(f.email),
      phone: asText(f.phone),
      status,
      isAthlete: !isGuardian,
      signupDate: asText(f.signup_date),
    };
    r.sourceRecordId = asText(f.source_person_id) ?? syntheticId(ctx.orgId, "zp-member", first?.toLowerCase(), last?.toLowerCase(), asText(f.dob), asText(f.email));
    if (asText(f.signup_date)) r.dates.push(asText(f.signup_date)!);
    return r;
  },
};

export const zpFamilyLinks: ImportSchemaDef = {
  id: "zenplanner.family_links",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Family links (guardian ↔ child)",
  description: "One row per guardian–child pair. Both people must already exist (import the member list first). Creates households, household membership and guardianships.",
  evidence: "unverified — configurable",
  recordEntityType: "family_link",
  allowCreatePerson: false,
  limitations:
    ZP_LIMITS +
    " New guardianships get conservative default permissions (training view, booking, form signing, messaging; NO health access, not emergency contact) — review each in People. Payer accounts are not created.",
  fields: [
    { key: "household_id", label: "Family / household ID", type: "text", aliases: ["family id", "household id", "family #"] },
    { key: "household_name", label: "Family / household name", type: "text", aliases: ["family", "family name", "household", "household name"] },
    { key: "guardian_id", label: "Guardian member ID", type: "text", aliases: ["guardian id", "parent id", "parent member id"] },
    { key: "guardian_name", label: "Guardian name", type: "text", required: true, aliases: ["guardian", "guardian name", "parent", "parent name"] },
    { key: "guardian_email", label: "Guardian email", type: "email", aliases: ["guardian email", "parent email"] },
    { key: "source_person_id", label: "Child member ID", type: "text", aliases: ["child id", "child member id", "athlete id", "member id"] },
    { key: "full_name", label: "Child name", type: "text", required: true, aliases: ["child", "child name", "athlete", "athlete name", "member name"] },
    { key: "dob", label: "Child date of birth", type: "date", aliases: ["child dob", "child birth date", "birth date", "dob"] },
    { key: "relationship", label: "Relationship", type: "text", aliases: ["relationship", "relation"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);
    const g = splitName(asText(f.guardian_name));
    if (!g.first || !g.last) r.errors.push("Guardian name must include first and last name.");
    const guardian = {
      sourceEntityType: "member",
      sourceId: asText(f.guardian_id),
      firstName: g.first,
      lastName: g.last,
      email: asText(f.guardian_email),
      adult: true,
      needsAthlete: false,
    };
    const household = asText(f.household_id) ?? asText(f.household_name) ?? `${g.last ?? ""} family (${asText(f.guardian_id) ?? asText(f.guardian_name)})`;
    r.data = {
      guardian,
      householdKey: household,
      householdName: asText(f.household_name) ?? `${g.last ?? "Imported"} Household`,
      relationship: (asText(f.relationship) ?? "parent").toLowerCase(),
    };
    r.sourceRecordId = syntheticId(ctx.orgId, "zp-family", household, asText(f.guardian_id) ?? asText(f.guardian_name)?.toLowerCase(), asText(f.source_person_id) ?? asText(f.full_name)?.toLowerCase());
    return r;
  },
};

const MEMBERSHIP_STATUS: Record<string, string> = {
  active: "active",
  current: "active",
  "on hold": "on_hold",
  hold: "on_hold",
  paused: "on_hold",
  frozen: "on_hold",
  cancelled: "cancelled",
  canceled: "cancelled",
  expired: "expired",
  ended: "expired",
  "past due": "past_due",
  pending: "pending",
  future: "pending",
  trial: "trialing",
};

export const zpMemberships: ImportSchemaDef = {
  id: "zenplanner.memberships",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Memberships",
  description: "Membership report export. Creates memberships billed externally (billing_provider = external_zenplanner) — no invoices, no provider subscriptions, no messages.",
  evidence: "unverified — configurable",
  recordEntityType: "membership",
  allowCreatePerson: false,
  limitations:
    ZP_LIMITS +
    " Each distinct plan name becomes an inactive, unlisted Teamwork product so it is never sold here; when the export has no price, the plan's price is recorded as 0 and labelled 'price not imported — billed in Zen Planner'.",
  fields: [
    { key: "membership_id", label: "Membership ID", type: "text", aliases: ["membership id", "contract id", "agreement id"] },
    ...personFields({ idAliases: ZP_ID, idLabel: "Zen Planner member ID" }),
    { key: "plan", label: "Plan / membership name", type: "text", required: true, aliases: ["membership", "membership name", "plan", "plan name", "membership type", "program"] },
    { key: "status", label: "Status", type: "text", required: true, aliases: ["status", "membership status"] },
    { key: "start_date", label: "Start date", type: "date", required: true, aliases: ["start date", "begin date", "start", "effective date"] },
    { key: "end_date", label: "End date", type: "date", aliases: ["end date", "expiration", "expiration date", "expires", "end"] },
    { key: "next_bill_date", label: "Next bill date", type: "date", aliases: ["next bill date", "next billing date", "next payment", "due date", "duedate"] },
    { key: "price", label: "Price per period", type: "number", aliases: ["price", "amount", "rate", "billing amount", "billamount", "bill amount"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);
    const st = asText(f.status);
    const status = st ? MEMBERSHIP_STATUS[st.toLowerCase()] : undefined;
    if (st && !status) r.errors.push(`Membership status "${st}" not recognized (expected Active, On Hold, Cancelled, Expired, Past Due, Pending, Trial).`);
    const price = asNum(f.price);
    r.data = {
      plan: asText(f.plan),
      status: status ?? null,
      startDate: asText(f.start_date),
      endDate: asText(f.end_date),
      nextBillDate: asText(f.next_bill_date),
      priceMinor: price ? Math.round(price.value * 100) : null,
      priceRaw: price?.raw ?? null,
    };
    if (!price) r.warnings.push("No price in export; plan price recorded as not imported.");
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}`.toLowerCase();
    r.sourceRecordId = asText(f.membership_id) ?? syntheticId(ctx.orgId, "zp-membership", personKey, asText(f.plan), asText(f.start_date));
    for (const d of [asText(f.start_date), asText(f.end_date)]) if (d) r.dates.push(d);
    return r;
  },
};

const ATTENDED = ["attended", "checked in", "check-in", "checked-in", "present", "visit", "visited", "yes"];
const NO_SHOW = ["no show", "no-show", "noshow", "absent", "missed"];
const NOT_CHECKIN = ["reserved", "rsvp", "rsvp'd", "rsvpd", "cancelled", "canceled", "late cancel", "late cancelled", "waitlist", "waitlisted"];

export const zpAttendance: ImportSchemaDef = {
  id: "zenplanner.attendance",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Attendance",
  description: "Attendance report export. Creates historical private sessions (marked imported) and attended/no-show bookings with source zenplanner. RSVP'd/cancelled rows are not check-ins and are skipped.",
  evidence: "existing Teamwork integration",
  recordEntityType: "attendance",
  allowCreatePerson: false,
  limitations:
    ZP_LIMITS +
    " Imported sessions are private historical records under an inactive 'Imported (Zen Planner)' service: they consume no credits, notify nobody, and are not bookable. Rows without a time are placed at the start of the day.",
  fields: [
    ...personFields({ idAliases: ZP_ID, idLabel: "Zen Planner member ID", nameAliases: ["name", "member", "member name", "attendee", "person", "athlete", "full name"] }),
    { key: "date", label: "Date", type: "date", required: true, aliases: ["date", "attendance date", "class date", "check-in date", "checkin date", "visit date"] },
    { key: "time", label: "Start time", type: "time", aliases: ["time", "start time", "class time", "check-in time"] },
    { key: "class_name", label: "Class / appointment", type: "text", aliases: ["class", "class name", "appointment", "event", "program", "service", "session"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "attendance status", "attendance"] },
    { key: "duration", label: "Duration (minutes)", type: "integer", aliases: ["duration", "minutes", "length"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);
    const date = asText(f.date);
    const time = asText(f.time);
    const statusText = (asText(f.status) ?? "attended").toLowerCase();
    let status: "attended" | "no_show" | "not_checkin" | null = null;
    if (ATTENDED.includes(statusText)) status = "attended";
    else if (NO_SHOW.includes(statusText)) status = "no_show";
    else if (NOT_CHECKIN.includes(statusText)) status = "not_checkin";
    else r.errors.push(`Attendance status "${asText(f.status)}" not recognized.`);
    if (status === "not_checkin") r.warnings.push(`"${asText(f.status)}" is a reservation/cancellation, not a check-in — row will be skipped.`);
    let startsAt: string | null = null;
    if (date) {
      const z = zonedLocalToInstant(date, time ?? "00:00:00", ctx.tz);
      if (z.warning) r.warnings.push(z.warning);
      if (!time) r.warnings.push("No time in export; session placed at start of day.");
      startsAt = z.date.toISOString();
      r.dates.push(date);
    }
    const dur = asNum(f.duration);
    r.data = {
      date,
      time,
      startsAt,
      sourceTimestamp: [date, time].filter(Boolean).join(" "),
      className: asText(f.class_name) ?? "Zen Planner visit",
      status,
      durationMinutes: dur?.value ?? 60,
    };
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}`.toLowerCase();
    r.sourceRecordId = syntheticId(ctx.orgId, "zp-attendance", personKey, date, time, asText(f.class_name));
    return r;
  },
};

export const zpDocumentsIndex: ImportSchemaDef = {
  id: "zenplanner.documents_index",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Signed documents (archive index)",
  description:
    "Upload a .zip containing one index CSV plus the signed PDFs it lists. Each file is archived as the original document (signatures are never recreated) and attached to the person.",
  evidence: "unverified — configurable",
  recordEntityType: "archived_document",
  allowCreatePerson: false,
  limitations:
    ZP_LIMITS +
    " Archived documents are originals only: Teamwork does not re-sign or re-validate them, and they do not satisfy Teamwork form requirements automatically.",
  fields: [
    ...personFields({ idAliases: ZP_ID, idLabel: "Zen Planner member ID" }),
    { key: "document_id", label: "Document ID", type: "text", aliases: ["document id", "waiver id", "form id"] },
    { key: "title", label: "Document title", type: "text", required: true, aliases: ["document", "title", "form", "waiver", "document name", "form name"] },
    { key: "signed_at", label: "Signed at", type: "datetime", aliases: ["signed", "signed at", "signed date", "date signed", "completed", "signature date"] },
    { key: "file", label: "File name in .zip", type: "text", required: true, aliases: ["file", "filename", "file name", "attachment", "path"] },
    { key: "signer", label: "Signed by", type: "text", aliases: ["signed by", "signer", "signer name"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: false }, r.errors);
    const signed = asDT(f.signed_at);
    r.data = {
      title: asText(f.title),
      file: asText(f.file),
      signedAt: signed?.iso ?? null,
      sourceTimestamp: signed?.raw ?? null,
      signer: asText(f.signer),
    };
    if (signed) r.dates.push(localDateOf(signed, ctx.tz));
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}`.toLowerCase();
    r.sourceRecordId = asText(f.document_id) ?? syntheticId(ctx.orgId, "zp-doc", personKey, asText(f.title), asText(f.file));
    return r;
  },
};
