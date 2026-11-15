import { matchVocab, PROSPECT_STATUS_TO_STAGE, type VocabKey } from "@/lib/zenplanner/vocab";
import { asText, parseDate, parseDateAndTime, parseMoneyMinor, parseNumber, parseTimeRange, syntheticId, zonedLocalToInstant } from "../normalize";
import type { Evidence, FieldDef, FieldValue, ImportSchemaDef, NormalizeCtx } from "../types";
import { emptyRow, identityFrom, resolveName } from "./common";

/**
 * Exact presets for Zen Planner's report grids (Person, Membership, Bill, Attendance).
 * Field labels are the grid column names from docs/ZENPLANNER-MAP.md (2026-11-13). The CSV header
 * spellings may differ slightly from the grid labels, so every field carries a few aliases and
 * headers are compared without case or punctuation; anything unmatched is listed, never fatal.
 *
 * Not yet tested against a real export file.
 */
export const GRID_EVIDENCE: Evidence = "built from the 2026-11-13 account map; not yet tested against a real export file";

const GRID_LIMITS =
  "Preset built from the 2026-11-13 Zen Planner account map. The Person, Membership and Bill presets were run against real exports on 2026-11-15; the Attendance preset has not seen a real file. Check the first import's mapping and preview carefully. Billing stays in Zen Planner: nothing here creates invoices, charges, subscriptions, messages, or jobs, and nothing is ever written back to Zen Planner.";

const EXPORT_BASE = "studio.zenplanner.com/zenplanner/studio/";

const PERSON_ID: FieldDef = { key: "source_person_id", label: "Person ID", type: "text", aliases: ["person id", "personid", "member id", "zp id", "id", "bar code", "barcode"], hint: "The real Person and Membership grids have no Person ID column; their Bar Code column is the person's number in Zen Planner and is used as the key. Without a key, people are matched by exact name plus birth date or email and always confirmed by staff." };
const NAME_FIELDS: FieldDef[] = [
  { key: "first_name", label: "First Name", type: "text", aliases: ["first name", "firstname", "first"] },
  { key: "last_name", label: "Last Name", type: "text", aliases: ["last name", "lastname", "last"] },
  { key: "full_name", label: "Name", type: "text", aliases: ["name", "full name", "person", "member", "member name", "attendee", "athlete", "client", "participant"] },
];

const YES_WORDS = new Set(["yes", "y", "true", "t", "1", "x", "on", "checked", "✓", "✔", "attended", "present"]);
const NO_WORDS = new Set(["no", "n", "false", "f", "0", "off", "unchecked", "absent"]);

/** Yes/No as the grids write it: Yes/No, Y/N, TRUE/FALSE, ON/OFF (the real Autopay? column), 1/0, in any letter case. */
const yes = (v: FieldValue, label: string, warnings: string[]): boolean | null => {
  const s = asText(v);
  if (s === null) return null;
  const t = s.trim().toLowerCase();
  if (YES_WORDS.has(t)) return true;
  if (NO_WORDS.has(t)) return false;
  warnings.push(`${label}: "${s}" is not Yes/No; left empty.`);
  return null;
};

/** The real Bill grid writes On-Time, Early or Late (blank on unpaid bills), not Yes/No. */
const paidOnTime = (v: FieldValue, warnings: string[]): boolean | null => {
  const t = asText(v)?.trim().toLowerCase().replace(/[\s_-]+/g, "") ?? null;
  if (t === "ontime" || t === "early") return true;
  if (t === "late") return false;
  return yes(v, "Paid On Time", warnings);
};

/** "$178.99", "1,234.50", "(12.00)", "-$45.00" → integer cents. Null (never 0) when empty; warns when unreadable. */
const money = (v: FieldValue, label: string, warnings: string[]): number | null => {
  const s = asText(v);
  if (s === null) return null;
  const cents = parseMoneyMinor(s);
  if (cents === undefined) {
    warnings.push(`${label}: "${s}" is not an amount; left empty.`);
    return null;
  }
  return cents;
};

const int = (v: FieldValue, label: string, warnings: string[]): number | null => {
  const s = asText(v);
  if (s === null) return null;
  const n = parseNumber(s);
  if (!n || !Number.isInteger(n.value)) {
    warnings.push(`${label}: "${s}" is not a whole number; left empty.`);
    return null;
  }
  return n.value;
};

/** Canonical list value, or the value as-is plus a flag when it is not on the list. */
function vocab(key: VocabKey, label: string, v: FieldValue, ctx: NormalizeCtx, flags: string[], warnings: string[]): string | null {
  const m = matchVocab(key, asText(v), ctx.vocab?.[key] ?? []);
  if (!m) return null;
  if (!m.known) {
    flags.push(`${label}: ${m.value}`);
    warnings.push(`${label} "${m.value}" is not on the hub's list; imported as written and flagged.`);
  }
  return m.value;
}

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

/** Tag names that are sports: the tag is kept AND the athlete's sport is set from it. */
export const KNOWN_SPORTS = [
  "Baseball", "Basketball", "Football", "Soccer", "Volleyball", "Softball", "Track", "Track and Field", "Cross Country", "Wrestling",
  "Swimming", "Tennis", "Golf", "Lacrosse", "Hockey", "Cheerleading", "Gymnastics", "Dance",
];

export function sportFromTags(tags: string[]): string | null {
  for (const t of tags) {
    const hit = KNOWN_SPORTS.find((s) => s.toLowerCase() === t.trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Zen Planner Person "Status" → hub person status. The exact Zen Planner values are unverified; unknown ones are flagged. */
const ZP_PERSON_STATUS: Record<string, "active" | "inactive" | "prospect"> = {
  member: "active",
  active: "active",
  student: "active",
  prospect: "prospect",
  lead: "prospect",
  alumni: "inactive",
  alumnus: "inactive",
  inactive: "inactive",
  former: "inactive",
  "former member": "inactive",
  "non-member": "inactive",
  "non member": "inactive",
  cancelled: "inactive",
  canceled: "inactive",
};

export const zpPersonGrid: ImportSchemaDef = {
  id: "zenplanner.person_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Person grid (exact preset)",
  description:
    "The People report grid exported as CSV. Creates or links people, households from Family ID, guardians from the Parent columns, leads for prospects, tags, and health notes. No column mapping needed when the listed columns are included.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "member",
  allowCreatePerson: true,
  limitations:
    GRID_LIMITS +
    " Existing people are never overwritten (only empty birth date, email and phone are filled). New guardian links get no health access and are not emergency contacts; a parent who matches someone already in Teamwork waits for staff confirmation. Special Needs, Medications and Allergies are health data: stored separately and readable only with health access. Address, Gender Identity, Bar Code and the attendance rollup columns are not imported.",
  exportHelp: {
    grid: "People (Person report grid)",
    path: `${EXPORT_BASE}person/index.cfm`,
    steps: [
      "In Zen Planner Studio open People, then the report grid (person/index.cfm).",
      "Choose columns and add every column in the list below. Clear any location or status filter so prospects and alumni are included (or note the filter you kept).",
      "Export as CSV. The grid's own export link works; the address has the form person/index.cfm?export=CSV&_c=<the chosen column names> (the column list goes in _c).",
      "Upload the file here and choose this preset. Nothing is sent back to Zen Planner.",
    ],
    columns: [
      "First Name", "Last Name", "Birth Date", "Email", "Phone", "Status", "Family ID", "Family", "Parent First", "Parent Last", "Parent Email",
      "Special Needs", "Medications", "Allergies", "Prospect Status", "Source", "Interest", "Referred By", "Prospect Priority", "Sales Rep", "Inquiry Date",
      "Trial End Date", "Tracking Source", "Tracking Name", "Tracking Medium", "Tracking Keywords", "Primary Instructor", "Primary Location", "Signup Date",
      "Has Password?", "Signed Documents", "Groups",
    ],
  },
  fields: [
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "date of birth", "dob", "birthday"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address", "e mail"] },
    { key: "phone", label: "Phone", type: "text", aliases: ["phone", "phone number", "mobile", "cell", "cell phone", "mobile phone", "home phone"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "person status", "member status"] },
    { key: "family_id", label: "Family ID", type: "text", aliases: ["family id", "familyid", "family #"], hint: "The household key. People sharing a Family ID join one household." },
    { key: "family_name", label: "Family", type: "text", aliases: ["family", "family name"] },
    { key: "parent_first", label: "Parent First", type: "text", aliases: ["parent first", "parent first name", "parent firstname"] },
    { key: "parent_last", label: "Parent Last", type: "text", aliases: ["parent last", "parent last name", "parent lastname"] },
    { key: "parent_email", label: "Parent Email", type: "email", aliases: ["parent email", "parent e mail", "parent email address"] },
    { key: "special_needs", label: "Special Needs", type: "text", aliases: ["special needs", "specialneeds"], hint: "Health data." },
    { key: "medications", label: "Medications", type: "text", aliases: ["medications", "medication"], hint: "Health data." },
    { key: "allergies", label: "Allergies", type: "text", aliases: ["allergies", "allergy"], hint: "Health data." },
    { key: "prospect_status", label: "Prospect Status", type: "text", aliases: ["prospect status"] },
    { key: "prospect_sub_status", label: "Prospect Sub Status", type: "text", aliases: ["prospect sub status", "prospect substatus", "prospect status sub"] },
    { key: "source", label: "Source", type: "text", aliases: ["source", "prospect source", "lead source"] },
    { key: "source_sub", label: "Sub Source", type: "text", aliases: ["sub source", "source sub", "subsource"] },
    { key: "interest", label: "Interest", type: "text", aliases: ["interest", "prospect interest"] },
    { key: "interest_sub", label: "Sub Interest", type: "text", aliases: ["sub interest", "interest sub", "subinterest"] },
    { key: "referred_by", label: "Referred By", type: "text", aliases: ["referred by", "referredby", "referral"] },
    { key: "priority", label: "Prospect Priority", type: "text", aliases: ["prospect priority", "priority"] },
    { key: "sales_rep", label: "Sales Rep", type: "text", aliases: ["sales rep", "salesrep", "sales representative"] },
    { key: "inquiry_date", label: "Inquiry Date", type: "date", aliases: ["inquiry date", "inquirydate", "inquired"] },
    { key: "trial_end_date", label: "Trial End Date", type: "date", aliases: ["trial end date", "trial end", "trialenddate"] },
    { key: "tracking_source", label: "Tracking Source", type: "text", aliases: ["tracking source", "utm source", "utm_source"] },
    { key: "tracking_name", label: "Tracking Name", type: "text", aliases: ["tracking name", "utm campaign", "utm_campaign", "tracking campaign"] },
    { key: "tracking_medium", label: "Tracking Medium", type: "text", aliases: ["tracking medium", "utm medium", "utm_medium"] },
    { key: "tracking_keywords", label: "Tracking Keywords", type: "text", aliases: ["tracking keywords", "utm term", "utm_term", "tracking keyword"] },
    { key: "primary_instructor", label: "Primary Instructor", type: "text", aliases: ["primary instructor", "instructor", "primary coach"] },
    { key: "primary_location", label: "Primary Location", type: "text", aliases: ["primary location", "location", "home location"] },
    { key: "signup_date", label: "Signup Date", type: "date", aliases: ["signup date", "sign up date", "signupdate", "join date", "member since"] },
    { key: "has_password", label: "Has Password?", type: "text", aliases: ["has password", "haspassword", "password"], hint: "Informational only." },
    { key: "signed_documents", label: "Signed Documents", type: "text", aliases: ["signed documents", "signed docs", "documents"], hint: "Informational only." },
    { key: "tags", label: "Groups (tags)", type: "text", aliases: ["groups", "group", "tags", "tag", "group names"], hint: "Comma or semicolon separated. A tag named after a known sport also sets the athlete's sport." },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const flags: string[] = [];
    const { first, last } = resolveName(f);
    const statusText = asText(f.status);
    const prospectStatusRaw = asText(f.prospect_status);
    let status: "active" | "inactive" | "prospect" | null = null;
    if (statusText) {
      status = ZP_PERSON_STATUS[statusText.trim().toLowerCase()] ?? null;
      if (!status) {
        flags.push(`Status: ${statusText}`);
        r.warnings.push(`Status "${statusText}" is not recognized; the person is imported as inactive and flagged. Set the right status in People.`);
        status = "inactive";
      }
    } else if (prospectStatusRaw) status = "prospect";
    const isProspect = status === "prospect";
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: !isProspect }, r.errors);

    const prospectStatus = vocab("prospectStatus", "Prospect Status", f.prospect_status, ctx, flags, r.warnings);
    const mapped = prospectStatus ? PROSPECT_STATUS_TO_STAGE[prospectStatus.toLowerCase()] : undefined;
    const source = vocab("source", "Source", f.source, ctx, flags, r.warnings);
    const interest = vocab("interest", "Interest", f.interest, ctx, flags, r.warnings);
    const priority = vocab("priority", "Priority", f.priority, ctx, flags, r.warnings);

    const pFirst = asText(f.parent_first);
    const pLast = asText(f.parent_last);
    const pEmail = asText(f.parent_email);
    let parent: { firstName: string; lastName: string; email: string | null } | null = null;
    if (pFirst && pLast) {
      const self = pFirst.toLowerCase() === (first ?? "").toLowerCase() && pLast.toLowerCase() === (last ?? "").toLowerCase();
      if (!self) parent = { firstName: pFirst, lastName: pLast, email: pEmail };
    } else if (pFirst || pLast || pEmail) {
      r.warnings.push("Parent columns are incomplete (need Parent First and Parent Last); no guardian will be linked from this row.");
    }

    const health = {
      specialNeeds: asText(f.special_needs),
      medications: asText(f.medications),
      allergies: asText(f.allergies),
    };
    const hasHealth = !!(health.specialNeeds || health.medications || health.allergies);
    const tags = (asText(f.tags) ?? "")
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const utm = {
      source: asText(f.tracking_source),
      campaign: asText(f.tracking_name),
      medium: asText(f.tracking_medium),
      term: asText(f.tracking_keywords),
    };
    const hasUtm = Object.values(utm).some(Boolean);
    const familyId = asText(f.family_id);
    r.data = {
      firstName: first,
      lastName: last,
      dob: asText(f.dob),
      email: asText(f.email),
      phone: asText(f.phone),
      status,
      zpStatus: statusText,
      isProspect,
      familyId,
      familyName: asText(f.family_name),
      parent,
      health: hasHealth ? health : null,
      prospect: isProspect
        ? {
            status: prospectStatus,
            subStatus: asText(f.prospect_sub_status),
            stage: mapped?.stage ?? "new",
            source,
            sourceSub: asText(f.source_sub),
            interest,
            interestSub: asText(f.interest_sub),
            referredBy: asText(f.referred_by),
            priority,
            salesRep: asText(f.sales_rep),
            inquiryDate: asText(f.inquiry_date),
            trialEndDate: asText(f.trial_end_date),
          }
        : null,
      // Members keep their original source for attribution reports even though no lead is created.
      memberSource: !isProspect ? source : null,
      utm: hasUtm ? utm : null,
      primaryInstructor: asText(f.primary_instructor),
      primaryLocation: asText(f.primary_location),
      signupDate: asText(f.signup_date),
      hasPassword: yes(f.has_password, "Has Password?", r.warnings),
      signedDocuments: asText(f.signed_documents),
      tags,
      sport: sportFromTags(tags),
      flags,
    };
    if (prospectStatus && !mapped) r.warnings.push(`Prospect Status "${prospectStatus}" has no stage mapping; the lead starts in the first stage.`);
    r.sourceRecordId = asText(f.source_person_id) ?? syntheticId(ctx.orgId, "zp-person", first?.toLowerCase(), last?.toLowerCase(), asText(f.dob), asText(f.email), familyId);
    for (const d of [asText(f.signup_date), asText(f.inquiry_date)]) if (d) r.dates.push(d);
    return r;
  },
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

const ZP_MEMBERSHIP_STATUS: Record<string, string> = {
  active: "active",
  current: "active",
  "on hold": "on_hold",
  hold: "on_hold",
  held: "on_hold",
  frozen: "on_hold",
  cancelled: "cancelled",
  canceled: "cancelled",
  dropped: "cancelled",
  expired: "expired",
  ended: "expired",
  completed: "expired",
  "past due": "past_due",
  pending: "pending",
  future: "pending",
  // Values seen in the real Membership grid export (2026-11-14): a membership that has not started yet, and one
  // with a cancellation scheduled (it stays active until its Cancel Date).
  "not started": "pending",
  "cancel pending": "active",
  trial: "trialing",
};

export const zpMembershipGrid: ImportSchemaDef = {
  id: "zenplanner.membership_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Membership grid (exact preset)",
  description:
    "The Membership report grid exported as CSV. Creates memberships that stay billed in Zen Planner (external_zenplanner), with the weekly limit, punch-card balance, cancel and hold details, and feeds the discount review. Import the Person grid first.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "membership",
  allowCreatePerson: false,
  limitations:
    GRID_LIMITS +
    " Each distinct plan (and weekly limit) becomes an inactive, unlisted product so it is never sold here; its price is the highest Payment Amount seen for that plan in the file, and each member's own Payment Amount is kept beside the membership. A weekly Att. Limit becomes the weekly class limit; other limit types are recorded but not enforced. Class Card Att. Remaining becomes an imported punch-card balance with no expiry date (Zen Planner's expiry is not in the grid). Installment, Signup Fee and Acct Name columns are not imported.",
  exportHelp: {
    grid: "Memberships (Membership report grid)",
    path: `${EXPORT_BASE}membership/index.cfm`,
    steps: [
      "In Zen Planner Studio open the Membership report grid (membership/index.cfm).",
      "Choose columns and add every column in the list below. Include cancelled and on-hold memberships if you want their history (or filter to current ones and say so in the coverage note).",
      "Export as CSV (membership/index.cfm?export=CSV&_c=<the chosen column names>).",
      "Import the Person grid first, then upload this file and choose this preset.",
    ],
    columns: [
      "First Name", "Last Name", "Membership", "Status", "Mbr. Begin Date", "Mbr. End Date", "Months", "Auto Renew", "Renewal Type", "Trial Member?",
      "Cancel Date", "Cancel By", "Cancel Reason", "Cancel Comments", "Payment Amount", "First Bill Due", "Income Category", "Att. Limit",
      "Att. Limit Type", "Class Card Att. Remaining", "Shared?", "Autopay?", "Family ID", "Birth Date", "Email",
    ],
  },
  fields: [
    { key: "membership_id", label: "Membership ID", type: "text", aliases: ["membership id", "membershipid", "mbr id", "number", "membership number", "mbr number"], hint: "The Membership grid's Number column: one per membership." },
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "dob"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address"] },
    { key: "plan", label: "Membership", type: "text", hint: "Rows with no Membership Label (drop-ins, class tuition, one-off items in the real export) are imported under a plan named after their Income Category and flagged.", aliases: ["membership", "membership label", "membership name", "mbr name", "membership option", "membership template", "plan", "plan name"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "mbr status", "membership status"], hint: "When the column is missing the status is worked out from the cancel, end and hold dates." },
    { key: "start_date", label: "Mbr. Begin Date", type: "date", required: true, aliases: ["mbr begin date", "membership begin date", "begin date", "mbr begin", "start date"] },
    { key: "end_date", label: "Mbr. End Date", type: "date", aliases: ["mbr end date", "membership end date", "end date", "mbr end", "expiration date"] },
    { key: "months", label: "Months", type: "text", aliases: ["months", "term months", "term"] },
    { key: "auto_renew", label: "Auto Renew", type: "text", aliases: ["auto renew", "autorenew", "auto renews"] },
    { key: "renewal_type", label: "Renewal Type", type: "text", aliases: ["renewal type", "renewaltype"] },
    { key: "trial_member", label: "Trial Member?", type: "text", aliases: ["trial member", "trialmember", "trial"] },
    { key: "cancel_date", label: "Cancel Date", type: "date", aliases: ["cancel date", "canceled date", "cancelled date", "drop date"] },
    { key: "cancel_by", label: "Cancel By", type: "text", aliases: ["cancel by", "canceled by", "cancelled by"] },
    { key: "cancel_reason", label: "Cancel Reason", type: "text", aliases: ["cancel reason", "drop reason", "cancellation reason"] },
    { key: "cancel_comments", label: "Cancel Comments", type: "text", aliases: ["cancel comments", "cancel comment", "cancellation comments"] },
    { key: "payment_amount", label: "Payment Amount", type: "text", aliases: ["payment amount", "paymentamount", "payment amt", "amount"] },
    { key: "first_bill_due", label: "First Bill Due", type: "date", aliases: ["first bill due", "first bill due date", "first bill"] },
    { key: "income_category", label: "Income Category", type: "text", aliases: ["income category", "incomecategory"] },
    { key: "membership_category", label: "Membership Category", type: "text", aliases: ["membership category", "category", "mbr category"] },
    { key: "att_limit", label: "Att. Limit", type: "text", aliases: ["att limit", "attendance limit", "attlimit"] },
    { key: "att_limit_type", label: "Att. Limit Type", type: "text", aliases: ["att limit type", "attendance limit type", "attlimittype"] },
    { key: "class_card_remaining", label: "Class Card Att. Remaining", type: "text", aliases: ["class card att remaining", "class card remaining", "class card attendance remaining", "att remaining"] },
    { key: "shared", label: "Shared?", type: "text", aliases: ["shared", "is shared"] },
    { key: "autopay", label: "Autopay?", type: "text", aliases: ["autopay", "auto pay", "is autopay"] },
    { key: "discount", label: "Discount", type: "text", aliases: ["discount", "discount name", "discount code"], hint: "Not in the account map's column list; mapped when the export has it." },
    { key: "hold_reason", label: "Hold Reason", type: "text", aliases: ["hold reason", "freeze reason"] },
    { key: "hold_start", label: "Hold Start Date", type: "date", aliases: ["hold start date", "hold start", "hold begin date", "hold from"] },
    { key: "hold_end", label: "Hold End Date", type: "date", aliases: ["hold end date", "hold end", "hold until", "hold to"] },
    { key: "family_id", label: "Family ID", type: "text", aliases: ["family id", "familyid"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const flags: string[] = [];
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);
    const today = ctx.today ?? new Date().toISOString().slice(0, 10);
    const cancelDate = asText(f.cancel_date);
    const endDate = asText(f.end_date);
    const holdStart = asText(f.hold_start);
    const holdEnd = asText(f.hold_end);
    const st = asText(f.status);
    let status = st ? ZP_MEMBERSHIP_STATUS[st.trim().toLowerCase()] : undefined;
    if (st && !status) r.errors.push(`Membership status "${st}" not recognized (expected Active/Current, On Hold, Cancelled, Cancel Pending, Expired/Completed, Past Due, Pending/Not Started, Trial).`);
    if (!st) {
      if (cancelDate && cancelDate <= today) status = "cancelled";
      else if (endDate && endDate < today) status = "expired";
      else if (holdStart && holdStart <= today && (!holdEnd || holdEnd >= today)) status = "on_hold";
      else if (asText(f.start_date) && asText(f.start_date)! > today) status = "pending";
      else status = "active";
      r.warnings.push(`No Status column; status worked out from the dates as "${status}".`);
    }
    const attLimit = int(f.att_limit, "Att. Limit", r.warnings);
    const attLimitType = asText(f.att_limit_type);
    let classesPerWeek: number | null = null;
    if (attLimit != null && attLimit > 0) {
      if (!attLimitType || /week/i.test(attLimitType)) {
        if (attLimit <= 14) classesPerWeek = attLimit;
        else r.warnings.push(`Att. Limit ${attLimit} per week is above the hub's maximum (14); recorded but not enforced.`);
        if (!attLimitType) r.warnings.push("Att. Limit has no Att. Limit Type; read as a weekly limit.");
      } else {
        r.warnings.push(`Att. Limit Type "${attLimitType}" is not weekly; the limit is recorded but not enforced as a weekly class limit.`);
      }
    }
    const classCard = int(f.class_card_remaining, "Class Card Att. Remaining", r.warnings);
    const payment = money(f.payment_amount, "Payment Amount", r.warnings);
    if (payment === null) r.warnings.push("No Payment Amount; left empty (not 0) and listed as unknown in the discount review.");
    const incomeCategory = vocab("incomeCategory", "Income Category", f.income_category, ctx, flags, r.warnings);
    let plan = asText(f.plan);
    if (!plan) {
      // About two thirds of the first real export: drop-ins, class tuition and other items sold without a label.
      plan = `No label: ${incomeCategory ?? "no Income Category"}`;
      flags.push("no_membership_label");
      r.warnings.push(`No Membership Label; imported under "${plan}".`);
    }
    // Zen Planner writes ERROR when autopay is on but its saved payment method is failing.
    const autopayText = asText(f.autopay);
    const autopayError = !!autopayText && autopayText.trim().toLowerCase() === "error";
    if (autopayError) {
      flags.push("autopay_error");
      r.warnings.push("Autopay? is ERROR in Zen Planner (the saved payment method is failing there); recorded as unknown and flagged.");
    }
    const inSeasonPlan = /in[\s-]?season/i.test(plan);
    if (inSeasonPlan && !endDate) r.warnings.push("In Season membership with no end date; imported as a regular membership.");
    r.data = {
      plan,
      status: status ?? null,
      startDate: asText(f.start_date),
      endDate,
      months: int(f.months, "Months", r.warnings),
      autoRenew: yes(f.auto_renew, "Auto Renew", r.warnings),
      renewalType: asText(f.renewal_type),
      trialMember: yes(f.trial_member, "Trial Member?", r.warnings),
      cancelDate,
      cancelBy: asText(f.cancel_by),
      cancelReason: vocab("dropReason", "Cancel Reason", f.cancel_reason, ctx, flags, r.warnings),
      cancelComments: asText(f.cancel_comments),
      paymentAmountMinor: payment,
      firstBillDue: asText(f.first_bill_due),
      incomeCategory,
      membershipCategory: vocab("membershipCategory", "Membership Category", f.membership_category, ctx, flags, r.warnings),
      attLimit,
      attLimitType,
      classesPerWeek,
      classCardRemaining: classCard,
      shared: yes(f.shared, "Shared?", r.warnings),
      autopay: autopayError ? null : yes(f.autopay, "Autopay?", r.warnings),
      discountName: asText(f.discount),
      holdReason: vocab("holdReason", "Hold Reason", f.hold_reason, ctx, flags, r.warnings),
      holdStart,
      holdEnd,
      familyId: asText(f.family_id),
      inSeason: inSeasonPlan && !!endDate,
      flags,
    };
    if (classCard != null && classCard < 0) {
      r.warnings.push("Class Card Att. Remaining is negative; no punch-card balance is created.");
    }
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.dob) ?? ""}`.toLowerCase();
    r.sourceRecordId = asText(f.membership_id) ?? syntheticId(ctx.orgId, "zp-membership", personKey, plan, asText(f.start_date));
    for (const d of [asText(f.start_date), endDate]) if (d) r.dates.push(d);
    return r;
  },
};

// ---------------------------------------------------------------------------
// Bill
// ---------------------------------------------------------------------------

/** Names as the Bill grid may write them: the person, or the account that pays. */
const BILL_NAME_FIELDS: FieldDef[] = NAME_FIELDS.map((f) => (f.key === "full_name" ? { ...f, aliases: [...(f.aliases ?? []), "acct name", "account name", "account", "bill to", "payer", "customer"] } : f));

/** Calendar dates outside this window are almost certainly a typo or a misread column, never real history. */
function implausibleDate(ymd: string, today: string, maxYearsAhead: number): boolean {
  return ymd < "1990-01-01" || ymd > `${Number(today.slice(0, 4)) + maxYearsAhead}-12-31`;
}

export const zpBillGrid: ImportSchemaDef = {
  id: "zenplanner.bill_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Bill grid (history only)",
  description:
    "The Bill report grid exported as CSV. Stored as imported billing history for the membership audit and scoreboard context. Never creates an invoice, a balance or anything payable.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "bill",
  allowCreatePerson: false,
  limitations:
    GRID_LIMITS +
    " Bills are history: they are kept in their own table, never become Teamwork invoices, and no family is ever asked to pay them here. Autopay Account and approval columns are not imported (payment account details stay in Zen Planner). A bill with no Due Date is filed under its Bill Date or Payment Date and says so; a bill with no date at all is rejected. Amounts that cannot be read are left empty (never 0) and flagged. Re-importing a bill that is already in the history skips it: a later change to its paid amount in Zen Planner is not picked up.",
  exportHelp: {
    grid: "Bills (Bill report grid)",
    path: `${EXPORT_BASE}bill/index.cfm`,
    steps: [
      "In Zen Planner Studio open the Bill report grid (bill/index.cfm).",
      "Choose columns and add every column in the list below. Set the due-date range you want as history.",
      "If the grid offers a Number (bill number), Birth Date or Email column, add them too: the number keeps a re-import from duplicating bills, and a birth date or email lets a bill be matched to the right person without a decision for each name.",
      "Export as CSV (bill/index.cfm?export=CSV&_c=<the chosen column names>). Do not add the Autopay Account columns.",
      "Import the Person grid first, then upload this file and choose this preset.",
    ],
    columns: ["First Name", "Last Name", "Description", "Due Date", "Amount Due", "Amount Paid", "Amount Unpaid", "Discount Total", "Paid On Time", "Status"],
  },
  requireOneOf: [{ keys: ["due_date", "bill_date", "paid_date"], label: "A date: Due Date, Bill Date or Payment Date" }],
  fields: [
    { key: "bill_id", label: "Bill ID", type: "text", aliases: ["bill id", "billid", "invoice id", "bill #", "bill number", "number", "bill no", "invoice number", "invoice #", "invoice no", "no"], hint: "The Bill grid's Number column when it has one: one per bill. If the column turns out to be the person's number, clear this mapping." },
    PERSON_ID,
    ...BILL_NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "dob"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address"] },
    { key: "description", label: "Description", type: "text", aliases: ["description", "bill description", "bill for", "item", "membership", "membership label", "memo"] },
    { key: "due_date", label: "Due Date", type: "text", aliases: ["due date", "duedate", "due", "date due"], hint: "When a bill has no Due Date, its Bill Date or Payment Date is used and the row says so." },
    { key: "bill_date", label: "Bill Date", type: "text", aliases: ["bill date", "billed", "billed on", "invoice date", "date", "created", "created date", "create date"] },
    { key: "paid_date", label: "Payment Date", type: "text", aliases: ["payment date", "paid date", "date paid", "paid on"] },
    { key: "amount_due", label: "Amount Due", type: "text", aliases: ["amount due", "amountdue", "bill amount", "billamount", "amount", "total", "total due"] },
    { key: "amount_paid", label: "Amount Paid", type: "text", aliases: ["amount paid", "amountpaid", "paid", "paid amount"] },
    { key: "amount_unpaid", label: "Amount Unpaid", type: "text", aliases: ["amount unpaid", "amountunpaid", "unpaid", "balance", "balance due", "amount owed"] },
    { key: "discount_total", label: "Discount Total", type: "text", aliases: ["discount total", "discounttotal", "discount", "discounts"] },
    { key: "paid_on_time", label: "Paid On Time", type: "text", aliases: ["paid on time", "paidontime", "on time"] },
    { key: "status", label: "Status", type: "text", aliases: ["status", "bill status"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const today = ctx.today ?? new Date().toISOString().slice(0, 10);
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: false }, r.errors);
    // Dates are read here, not by the generic typing step, so one odd cell never hides a usable date in another column.
    const dateOf = (key: string, label: string): string | null => {
      const s = asText(f[key]);
      if (s === null) return null;
      const d = parseDate(s);
      if (!d) r.warnings.push(`${label}: unrecognized date "${s}"; ignored.`);
      return d;
    };
    const dueRead = dateOf("due_date", "Due Date");
    const billDate = dateOf("bill_date", "Bill Date");
    const paidDate = dateOf("paid_date", "Payment Date");
    let due = dueRead;
    if (!due && billDate) {
      due = billDate;
      r.warnings.push("No Due Date; filed under its Bill Date.");
    } else if (!due && paidDate) {
      due = paidDate;
      r.warnings.push("No Due Date; filed under its Payment Date.");
    }
    if (!due) r.errors.push("No usable Due Date, Bill Date or Payment Date: a bill needs a date to be kept as history.");
    else if (implausibleDate(due, today, 10)) {
      r.errors.push(`Due Date ${due} is outside the years a bill can belong to (1990 to ${Number(today.slice(0, 4)) + 10}).`);
      due = null;
    }
    const amountDue = money(f.amount_due, "Amount Due", r.warnings);
    const amountPaid = money(f.amount_paid, "Amount Paid", r.warnings);
    const amountUnpaid = money(f.amount_unpaid, "Amount Unpaid", r.warnings);
    const discountTotal = money(f.discount_total, "Discount Total", r.warnings);
    const negative = [amountDue, amountPaid, amountUnpaid].some((a) => a != null && a < 0);
    if (negative) r.warnings.push("Negative amount (a credit or refund in Zen Planner); kept as written.");
    if (amountDue != null && amountPaid != null && amountUnpaid != null && amountDue - amountPaid !== amountUnpaid) {
      r.warnings.push("Amount Due minus Amount Paid does not equal Amount Unpaid in the export; all three kept as written.");
    }
    const description = asText(f.description);
    r.data = {
      description,
      dueDate: due,
      amountDueMinor: amountDue,
      amountPaidMinor: amountPaid,
      amountUnpaidMinor: amountUnpaid,
      discountTotalMinor: discountTotal,
      paidOnTime: paidOnTime(f.paid_on_time, r.warnings),
      zpStatus: asText(f.status),
    };
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.dob) ?? ""}`.toLowerCase();
    r.sourceRecordId = asText(f.bill_id) ?? syntheticId(ctx.orgId, "zp-bill", personKey, due, description, asText(f.amount_due));
    if (due) r.dates.push(due);
    return r;
  },
};

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/** Status words that say whether a visit happened, for exports that have a Status column instead of (or beside) Att. */
const ZP_ATTENDANCE_STATUS: Record<string, { visit: boolean; why: string }> = {
  attended: { visit: true, why: "" },
  present: { visit: true, why: "" },
  "checked in": { visit: true, why: "" },
  "checked-in": { visit: true, why: "" },
  "check in": { visit: true, why: "" },
  completed: { visit: true, why: "" },
  late: { visit: true, why: "" },
  reserved: { visit: false, why: "Reserved only" },
  registered: { visit: false, why: "Reserved only" },
  booked: { visit: false, why: "Reserved only" },
  rsvp: { visit: false, why: "Reserved only" },
  pending: { visit: false, why: "Pending" },
  waitlist: { visit: false, why: "Waitlisted" },
  waitlisted: { visit: false, why: "Waitlisted" },
  "no show": { visit: false, why: "No show" },
  "no-show": { visit: false, why: "No show" },
  noshow: { visit: false, why: "No show" },
  absent: { visit: false, why: "Absent" },
  missed: { visit: false, why: "Absent" },
  canceled: { visit: false, why: "Canceled" },
  cancelled: { visit: false, why: "Canceled" },
  "late cancel": { visit: false, why: "Canceled" },
  "late canceled": { visit: false, why: "Canceled" },
  "late cancelled": { visit: false, why: "Canceled" },
};

export const zpAttendanceGrid: ImportSchemaDef = {
  id: "zenplanner.attendance_grid",
  source: "zenplanner",
  idSource: "zenplanner",
  label: "Zen Planner — Attendance grid (exact preset)",
  description:
    "The Attendance report grid exported as CSV. A row is a visit only when Att. = Yes; Rsvp and Canceled are separate columns and rows without Att. = Yes are skipped. Creates historical sessions and attended bookings.",
  evidence: GRID_EVIDENCE,
  recordEntityType: "attendance",
  allowCreatePerson: false,
  limitations:
    GRID_LIMITS +
    " Imported sessions are private historical records under an inactive 'Imported (Zen Planner)' service: they consume no credits, notify nobody, and are not bookable. Location is linked when its name matches a hub location exactly; Session Type, Program and Staff Member are kept as text on the session. Rows without a time (or with a time that cannot be read) are placed at the start of the day. A blank Att. cell is read as not a visit and skipped; an Att. value that is neither yes nor no is rejected for that row only. When the export has a Status column instead of Att., only Attended / Present / Checked In / Completed / Late count as a visit.",
  exportHelp: {
    grid: "Attendance (Attendance report grid)",
    path: `${EXPORT_BASE}attendance/index.cfm`,
    steps: [
      "In Zen Planner Studio open the Attendance report grid (attendance/index.cfm).",
      "Choose columns and add every column in the list below. Att. must be included: it is the only column that says a visit happened.",
      "If the grid offers Birth Date or Email columns, add them too: they let a visit be matched to the right person without a decision for each name.",
      "Set the date range, then export as CSV (attendance/index.cfm?export=CSV&_c=<the chosen column names>).",
      "Import the Person grid first, then upload this file and choose this preset.",
    ],
    columns: ["First Name", "Last Name", "Date", "Time", "Att.", "Rsvp", "Canceled", "Session Type", "Program", "Location", "Staff Member"],
  },
  requireOneOf: [{ keys: ["att", "att_status"], label: "Att. (or a Status column that says who attended)" }],
  fields: [
    { key: "attendance_id", label: "Attendance ID", type: "text", aliases: ["attendance id", "attendanceid", "att id", "record id", "number", "no"], hint: "Optional. Kept as part of the row's identity; safe to map even if the column is the person's number." },
    PERSON_ID,
    ...NAME_FIELDS,
    { key: "dob", label: "Birth Date", type: "date", aliases: ["birth date", "birthdate", "dob"] },
    { key: "email", label: "Email", type: "email", aliases: ["email", "email address"] },
    { key: "date", label: "Date", type: "text", required: true, aliases: ["date", "attendance date", "att date", "class date", "session date", "date time", "datetime", "date/time", "start", "start date"], hint: "A date, or a date with a time (Nov 14, 2026 4:30 PM)." },
    { key: "time", label: "Time", type: "text", aliases: ["time", "start time", "class time", "session time"], hint: "Optional when the Date column carries the time. A range (4:30 PM - 5:30 PM) sets the session length." },
    { key: "att", label: "Att.", type: "text", aliases: ["att", "attended", "attendance", "att?", "attended?"], hint: "Only Yes (or ON) counts as a visit. Blank is read as not a visit." },
    { key: "att_status", label: "Status", type: "text", aliases: ["status", "attendance status", "att status", "result"], hint: "Used only when Att. is not in the file or is blank on the row." },
    { key: "rsvp", label: "Rsvp", type: "text", aliases: ["rsvp", "rsvp?", "reserved", "reservation"] },
    { key: "canceled", label: "Canceled", type: "text", aliases: ["canceled", "cancelled", "canceled?", "cancelled?"] },
    { key: "session_type", label: "Session Type", type: "text", aliases: ["session type", "sessiontype", "type"] },
    { key: "program", label: "Program", type: "text", aliases: ["program", "program name"] },
    { key: "location", label: "Location", type: "text", aliases: ["location", "location name"] },
    { key: "staff", label: "Staff Member", type: "text", aliases: ["staff member", "staff", "instructor", "coach"] },
    { key: "class_name", label: "Class", type: "text", aliases: ["class", "class name", "session", "session name", "event", "appointment"] },
  ],
  normalize(f, _raw, ctx) {
    const r = emptyRow();
    const today = ctx.today ?? new Date().toISOString().slice(0, 10);
    r.identity = identityFrom(f, ctx, { sourceEntityType: "member", needsAthlete: true }, r.errors);

    // Date, with the time taken from the Time column or from the Date cell itself ("Nov 14, 2026 4:30 PM").
    const dateText = asText(f.date);
    const dt = dateText ? parseDateAndTime(dateText) : null;
    let date = dt?.date ?? null;
    if (dateText && !date) r.errors.push(`Date: unrecognized date "${dateText}".`);
    if (date && implausibleDate(date, today, 1)) {
      r.errors.push(`Date ${date} is outside the years a visit can belong to (1990 to ${Number(today.slice(0, 4)) + 1}).`);
      date = null;
    }
    const timeText = asText(f.time);
    const range = timeText ? parseTimeRange(timeText) : null;
    if (timeText && !range) r.warnings.push(`Time "${timeText}" is not a time; the visit is placed at the start of the day.`);
    const time = range?.start ?? dt?.time ?? null;
    const endTime = range ? range.end : (dt?.endTime ?? null);
    let durationMinutes = 60;
    if (time && endTime) {
      const mins = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
      const d = mins(endTime) - mins(time);
      if (d >= 5 && d <= 480) durationMinutes = d;
    }

    // Did a visit happen? Att. decides; Status is only consulted when Att. is absent or blank.
    const attText = asText(f.att);
    const att = yes(f.att, "Att.", []);
    const statusText = asText(f.att_status);
    const statusWord = statusText ? ZP_ATTENDANCE_STATUS[statusText.trim().toLowerCase()] : undefined;
    const rsvp = yes(f.rsvp, "Rsvp", r.warnings);
    const canceled = yes(f.canceled, "Canceled", r.warnings);
    // A row is a visit only when Att. = Yes. Rsvp and Canceled never make (or unmake) a visit.
    let status: "attended" | "not_checkin" = "not_checkin";
    let skipReason: string | null = null;
    if (attText !== null && att === null) {
      r.errors.push(`Att. "${attText}" is neither yes nor no: this row cannot be counted or skipped safely.`);
    } else if (att === true) {
      status = "attended";
      if (canceled) r.warnings.push("Att. = Yes on a row also marked Canceled; counted as a visit because Att. decides.");
      if (statusWord && !statusWord.visit) r.warnings.push(`Att. = Yes but Status is "${statusText}"; counted as a visit because Att. decides.`);
    } else if (att === false) {
      skipReason = canceled ? "Canceled, Att. is not Yes: not a visit" : rsvp ? "Rsvp only, Att. is not Yes: not a visit" : "Att. is not Yes: not a visit";
    } else if (statusText !== null) {
      // No Att. value on this row: the Status word decides.
      if (!statusWord) r.errors.push(`Status "${statusText}" is not a word this import knows (Attended, Present, Checked In, Reserved, No Show, Canceled ...) and Att. is blank.`);
      else if (statusWord.visit) status = "attended";
      else skipReason = `${statusWord.why}: not a visit`;
    } else {
      skipReason = canceled ? "Canceled, Att. is blank: not a visit" : rsvp ? "Rsvp only, Att. is blank: not a visit" : "Att. is blank: not a visit";
    }

    let startsAt: string | null = null;
    if (date) {
      const z = zonedLocalToInstant(date, time ?? "00:00:00", ctx.tz);
      if (z.warning) r.warnings.push(z.warning);
      if (!time && status === "attended" && !(timeText && !range)) r.warnings.push("No time in export; session placed at start of day.");
      if (status === "attended" && date > today) r.warnings.push(`Att. = Yes on a date in the future (${date}); imported as written.`);
      startsAt = z.date.toISOString();
      r.dates.push(date);
    }
    const program = asText(f.program);
    const sessionType = asText(f.session_type);
    const className = (asText(f.class_name) ?? program ?? sessionType ?? "Zen Planner visit").slice(0, 200);
    r.data = {
      date,
      time,
      startsAt,
      sourceTimestamp: [date, time].filter(Boolean).join(" "),
      className,
      status,
      skipReason,
      att,
      rsvp,
      canceled,
      zpStatus: statusText,
      sessionType,
      program,
      locationName: asText(f.location),
      staffName: asText(f.staff),
      durationMinutes,
    };
    const personKey = asText(f.source_person_id) ?? `${resolveName(f).first}|${resolveName(f).last}|${asText(f.dob) ?? ""}`.toLowerCase();
    const attendanceId = asText(f.attendance_id);
    // The grid's own number is folded into the natural key rather than trusted alone: if the column is really the
    // person's number, every visit still gets its own id. Files without the column keep the ids they always had.
    const natural = [personKey, date, time, asText(f.class_name) ?? program ?? sessionType, asText(f.location)];
    r.sourceRecordId = attendanceId ? syntheticId(ctx.orgId, "zp-attendance", ...natural, attendanceId) : syntheticId(ctx.orgId, "zp-attendance", ...natural);
    return r;
  },
};

export const ZP_GRID_SCHEMAS = [zpPersonGrid, zpMembershipGrid, zpBillGrid, zpAttendanceGrid];

/** Headers the preset did not recognize (after alias + punctuation-insensitive matching). */
export function unmatchedHeaders(headers: string[], mapping: Record<string, string>): string[] {
  const mapped = new Set(Object.entries(mapping).filter(([k]) => !k.startsWith("$option.")).map(([, v]) => v));
  return headers.filter((h) => !mapped.has(h) && !h.startsWith("_"));
}
